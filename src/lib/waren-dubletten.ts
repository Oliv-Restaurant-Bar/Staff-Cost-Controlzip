/**
 * waren-dubletten — Doppelt erfasste Warenrechnungen eines Monats finden
 * ======================================================================
 * Über-Erfassung entsteht, wenn dieselbe Rechnung über MEHRERE Pfade in den
 * Bestand kam (Detail-Import PDF/CSV, FIBU-Übernahme, Kreditoren-Übernahme).
 * Reine Logik (node-testbar), löscht selbst NICHTS — die Seite zeigt die
 * Gruppen als Vorschau und löscht erst nach Bestätigung.
 *
 * Duplikat-Erkennung (pro kanonischem Lieferanten, Alias-Gruppen-Resolver):
 *  1. REFERENZ: gleiche Basis-Rechnungsnummer (normRef extrahiert bei
 *     FIBU-Übernahme-Referenzen «Beleg · Rechnungsnr» die Nummer NACH dem
 *     Trennpunkt). Mehrere Buchungszeilen derselben Quelle mit derselben
 *     Nummer (FIBU-Split einer Rechnung) zählen zusammen als EIN Beleg.
 *  2. BETRAG+DATUM: Eintrag OHNE Referenz, der einem Referenz-Eintrag bzw.
 *     Eintrag desselben (verwandten) Lieferanten mit gleichem Datum und
 *     Netto-Betrag ±0.05 entspricht (z.B. Kreditoren-Übernahme ohne Beleg-Nr).
 *  3. SAMMELRECHNUNG: eine einzelne Übernahme (quelle *_uebernahme, ≥ CHF 500),
 *     deren Betrag der Summe von ≥3 anderen (Detail-)Einträgen desselben
 *     Lieferanten entspricht (Toleranz max(5, 0.5 %)) — Monats-Sammelrechnung
 *     neben den Einzelrechnungen.
 *
 * Behalten-Regel je Gruppe (bester Rang, alle Einträge des besten Rangs):
 *  final=true  >  Detail-Quellen (Monatsrechnung/PDF/CSV/manuell)  >
 *  fibu_uebernahme  >  kreditoren_uebernahme.
 *  Bei gleichem Rang (echter Doppel-Import) bleibt der älteste (createdAt).
 */

import type { InvoiceEntry } from '@/lib/waren-db';
import { normRef } from '@/lib/waren-ref';
import { buildAliasResolver, type AliasGruppe } from '@/lib/waren-alias-gruppen';
import { normalizeSupplierKey } from '@/lib/waren-pdf-erkennung';

export interface DublettenGruppe {
  /** Kanonischer Lieferant (Alias-Gruppen aufgelöst). */
  lieferant: string;
  grund: 'referenz' | 'betrag_datum' | 'sammelrechnung';
  /** Anzeige-Schlüssel (Basis-Rechnungsnummer bzw. Beschreibung). */
  schluessel: string;
  behalten: InvoiceEntry[];
  loeschen: InvoiceEntry[];
}

/** Quellen-Rang: kleiner = bevorzugt behalten. */
function quelleRang(e: InvoiceEntry): number {
  if (e.final === true) return 0;
  switch (e.quelle) {
    case 'fibu_uebernahme': return 2;
    case 'kreditoren_uebernahme': return 3;
    default: return 1; // Detail: monatsrechnung/auftragsbestaetigung/CSV/PDF/manuell
  }
}

/**
 * «Verwandte» Lieferanten-Namen: gleicher normalisierter Kern ODER der eine
 * enthält den anderen als Token-Folge («La Marra GmbH, 06.2026» ⊇ «La Marra»).
 * Nur für die Betrag+Datum-Zuordnung — nie für Beträge/Aggregation.
 */
export function lieferantVerwandt(a: string, b: string): boolean {
  const na = normalizeSupplierKey(a), nb = normalizeSupplierKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const pa = ` ${na} `, pb = ` ${nb} `;
  return pa.includes(` ${nb} `) || pb.includes(` ${na} `);
}

function sortiertNachAlter(list: InvoiceEntry[]): InvoiceEntry[] {
  return [...list].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

/** Gruppe in behalten/löschen teilen (bester Rang bleibt; Rang-Gleichstand → ältester Beleg). */
function teileGruppe(mitglieder: InvoiceEntry[]): { behalten: InvoiceEntry[]; loeschen: InvoiceEntry[] } {
  const bester = Math.min(...mitglieder.map(quelleRang));
  const besteAlle = mitglieder.filter(e => quelleRang(e) === bester);
  const rest = mitglieder.filter(e => quelleRang(e) !== bester);
  // Innerhalb des besten Rangs: FIBU-Split-Zeilen derselben Rechnung gehören
  // ZUSAMMEN (gleiche Quelle) — bei fibu_uebernahme bleiben alle Zeilen,
  // sonst der älteste Eintrag.
  if (besteAlle.length > 1 && besteAlle[0].quelle !== 'fibu_uebernahme') {
    const sortiert = sortiertNachAlter(besteAlle);
    return { behalten: [sortiert[0]], loeschen: [...sortiert.slice(1), ...rest] };
  }
  return { behalten: besteAlle, loeschen: rest };
}

/**
 * Referenz-Gruppe teilen. WICHTIG: Detail-Belege (Rang ≤1) mit GLEICHER
 * Nummer, aber VERSCHIEDENEN Daten sind KEINE Duplikate — Portale (z.B.
 * Transgourmet) verwenden Rechnungsnummern wieder; Dokument-Identität ist
 * Nummer+Datum. Übernahmen (FIBU/Kreditoren) sind dagegen redundant, sobald
 * irgendein Detail-Beleg mit der Nummer existiert. final=true wird NIE gelöscht.
 */
function teileReferenzGruppe(mitglieder: InvoiceEntry[]): { behalten: InvoiceEntry[]; loeschen: InvoiceEntry[] } {
  const behalten: InvoiceEntry[] = [];
  const loeschen: InvoiceEntry[] = [];
  const details = mitglieder.filter(e => quelleRang(e) <= 1);
  const fibu = mitglieder.filter(e => quelleRang(e) === 2);
  const kred = mitglieder.filter(e => quelleRang(e) === 3);
  // Detail-Belege: pro Datum EIN Beleg (ältester); gleiche Nr. an anderem
  // Datum bleibt (Nummern-Wiederverwendung).
  const proDatum = new Map<string, InvoiceEntry[]>();
  for (const e of details) proDatum.set(e.date, [...(proDatum.get(e.date) ?? []), e]);
  for (const liste of proDatum.values()) {
    const sortiert = sortiertNachAlter(liste);
    // final=true nie löschen — falls mehrere final, bleiben alle final.
    const finals = sortiert.filter(e => e.final === true);
    if (finals.length > 0) {
      behalten.push(...finals);
      loeschen.push(...sortiert.filter(e => e.final !== true));
    } else {
      behalten.push(sortiert[0]);
      loeschen.push(...sortiert.slice(1));
    }
  }
  // Übernahmen: redundant, sobald ein Detail-Beleg existiert.
  if (behalten.length > 0) {
    loeschen.push(...fibu, ...kred);
  } else if (fibu.length > 0) {
    behalten.push(...fibu); // FIBU-Splits derselben Rechnung zusammen behalten
    loeschen.push(...kred);
  } else {
    const sortiert = sortiertNachAlter(kred);
    behalten.push(sortiert[0]);
    loeschen.push(...sortiert.slice(1));
  }
  return { behalten, loeschen: loeschen.filter(e => e.final !== true) };
}

export function findeDublettenGruppen(
  invoices: InvoiceEntry[],
  aliasGruppen: AliasGruppe[],
): DublettenGruppe[] {
  const resolve = buildAliasResolver(aliasGruppen);
  const gruppen: DublettenGruppe[] = [];
  const verplant = new Set<string>(); // entry.id → schon in einer Gruppe

  // ── 1) Referenz-Gruppen (kanonischer Lieferant + Basis-Rechnungsnummer) ──
  const refMap = new Map<string, InvoiceEntry[]>();
  for (const e of invoices) {
    const ref = normRef(e.reference);
    if (!ref) continue;
    const key = `${normalizeSupplierKey(resolve(e.supplierName))}|${ref}`;
    refMap.set(key, [...(refMap.get(key) ?? []), e]);
  }
  for (const [key, mitglieder] of refMap) {
    if (mitglieder.length < 2) continue;
    const { behalten, loeschen } = teileReferenzGruppe(mitglieder);
    if (loeschen.length === 0) continue;
    for (const e of mitglieder) verplant.add(e.id);
    gruppen.push({
      lieferant: resolve(mitglieder[0].supplierName),
      grund: 'referenz',
      schluessel: key.split('|')[1],
      behalten, loeschen,
    });
  }

  // ── 2) Referenzlose Einträge: gleiches Datum + Netto ±0.05 bei verwandtem
  //       Lieferanten (z.B. Kreditoren-Übernahme ohne Beleg-Nr) ──
  const ohneRef = invoices.filter(e => !normRef(e.reference) && !verplant.has(e.id));
  for (const e of ohneRef) {
    if (verplant.has(e.id)) continue;
    const partner = invoices.filter(o =>
      o.id !== e.id && !verplant.has(o.id) && o.date === e.date
      && Math.abs(o.amountNet - e.amountNet) <= 0.05
      && lieferantVerwandt(o.supplierName, e.supplierName));
    if (partner.length === 0) continue;
    const mitglieder = [e, ...partner];
    const { behalten, loeschen } = teileGruppe(mitglieder);
    if (loeschen.length === 0) continue;
    for (const m of mitglieder) verplant.add(m.id);
    gruppen.push({
      lieferant: resolve(partner[0].supplierName),
      grund: 'betrag_datum',
      schluessel: `${e.date} · CHF ${e.amountNet.toFixed(2)}`,
      behalten, loeschen,
    });
  }

  // ── 3) Sammelrechnung: EIN Übernahme-Eintrag ≈ Summe der übrigen Einträge
  //       desselben Lieferanten (≥3 Stück, Toleranz max(5, 0.5 %)) ──
  const proLieferant = new Map<string, InvoiceEntry[]>();
  for (const e of invoices) {
    if (verplant.has(e.id)) continue;
    const canon = normalizeSupplierKey(resolve(e.supplierName));
    proLieferant.set(canon, [...(proLieferant.get(canon) ?? []), e]);
  }
  for (const liste of proLieferant.values()) {
    for (const e of liste) {
      if (verplant.has(e.id)) continue;
      const istUebernahme = e.quelle === 'fibu_uebernahme' || e.quelle === 'kreditoren_uebernahme';
      if (!istUebernahme || e.final === true || e.amountNet < 500) continue;
      // Detail-Belege = Rang ≤1 (final=true zählt dazu — finalisierte
      // Einzelrechnungen sind gerade die typische Gegenseite einer Sammelrechnung).
      const andere = liste.filter(o => o.id !== e.id && !verplant.has(o.id) && quelleRang(o) <= 1);
      if (andere.length < 3) continue;
      const summe = andere.reduce((a, o) => a + o.amountNet, 0);
      const tol = Math.max(5, e.amountNet * 0.005);
      if (Math.abs(summe - e.amountNet) > tol) continue;
      verplant.add(e.id);
      for (const o of andere) verplant.add(o.id);
      gruppen.push({
        lieferant: resolve(e.supplierName),
        grund: 'sammelrechnung',
        schluessel: `Sammelrechnung ${e.reference ?? e.date} ≈ ${andere.length} Einzelrechnungen`,
        behalten: andere,
        loeschen: [e],
      });
    }
  }

  return gruppen.sort((a, b) =>
    b.loeschen.reduce((x, e) => x + e.amountNet, 0) - a.loeschen.reduce((x, e) => x + e.amountNet, 0));
}
