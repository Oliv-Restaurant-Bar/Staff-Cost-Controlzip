/**
 * waren-klassen.ts — Kontoklassen für Warenrechnungen (pure, IO-frei)
 * ====================================================================
 * Klassifikation NACH KONTONUMMER:
 *   - Konten 4000 … Grenze (Standard 4070)  → WARENKOSTEN  (zählen in WKQ)
 *   - Konten > Grenze (z.B. 4071, 6040)     → BETRIEBSKOSTEN (NICHT in WKQ)
 *   - Konten < 4000                          → BETRIEBSKOSTEN (kein Warenkonto)
 * Die Grenze ist pro Mandant konfigurierbar (waren-db: loadWarenkostenGrenze).
 *
 * Legacy-Regel: Einträge OHNE Konto (Altbestand/Import) zählen als WARENKOSTEN —
 * so bleiben historische Totale und die WKQ unverändert.
 *
 * Split-Rechnungen (kontoSplits, beliebig viele Zeilen) werden je Zeile
 * klassiert — keine Doppelzählung: waren + betrieb = Rechnungsnetto.
 */

import type { InvoiceEntry } from './waren-db';

/** Standard-Obergrenze der Warenkosten-Konten (4000–4070). */
export const DEFAULT_WARENKOSTEN_GRENZE = 4070;

export type KontoKlasse = 'warenkosten' | 'betriebskosten';

/**
 * Klasse eines Kontos aus der Nummer. Kein/kein-numerisches Konto → warenkosten
 * (Legacy-Regel, siehe Kopfkommentar).
 */
export function kontoKlasse(konto: string | undefined, grenze: number = DEFAULT_WARENKOSTEN_GRENZE): KontoKlasse {
  if (!konto) return 'warenkosten';
  const n = parseInt(konto, 10);
  if (!Number.isFinite(n)) return 'warenkosten';
  return n >= 4000 && n <= grenze ? 'warenkosten' : 'betriebskosten';
}

export function kontoKlasseLabel(k: KontoKlasse): string {
  return k === 'warenkosten' ? 'Warenkosten' : 'Betriebskosten';
}

export interface KlassenAnteile {
  /** Netto-Anteil auf Warenkosten-Konten (4000–Grenze). */
  warenNet: number;
  /** Netto-Anteil auf Betriebskosten-Konten (> Grenze bzw. < 4000). */
  betriebNet: number;
}

/**
 * Netto-Anteile einer Rechnung je Kontoklasse. Split-Rechnung: je Split-Zeile;
 * sonst ganzer Betrag nach `warenkonto`. Summe = amountNet (keine Doppelzählung).
 */
export function klassenAnteile(e: InvoiceEntry, grenze: number = DEFAULT_WARENKOSTEN_GRENZE): KlassenAnteile {
  const r = { warenNet: 0, betriebNet: 0 };
  if (e.kontoSplits && e.kontoSplits.length > 0) {
    for (const s of e.kontoSplits) {
      const net = Number.isFinite(s.amountNet) ? s.amountNet : 0;
      if (kontoKlasse(s.warenkonto, grenze) === 'warenkosten') r.warenNet += net;
      else r.betriebNet += net;
    }
    return r;
  }
  const net = Number.isFinite(e.amountNet) ? e.amountNet : 0;
  if (kontoKlasse(e.warenkonto, grenze) === 'warenkosten') r.warenNet = net;
  else r.betriebNet = net;
  return r;
}

/** Netto-Summe der WARENKOSTEN-Anteile (Basis von «Warenkosten total» und WKQ). */
export function sumWarenNet(invoices: InvoiceEntry[], grenze: number = DEFAULT_WARENKOSTEN_GRENZE): number {
  return invoices.reduce((s, e) => s + klassenAnteile(e, grenze).warenNet, 0);
}

/** Netto-Summe der BETRIEBSKOSTEN-Anteile (separat, NIE in der WKQ). */
export function sumBetriebNet(invoices: InvoiceEntry[], grenze: number = DEFAULT_WARENKOSTEN_GRENZE): number {
  return invoices.reduce((s, e) => s + klassenAnteile(e, grenze).betriebNet, 0);
}

export interface SupplierKlassenRow {
  supplierName: string;
  /** GESAMT-Total über ALLE Konten (Waren + Betrieb) — Basis für FIBU-Vergleich. */
  totalNet: number;
  /** davon Warenkosten (4000–Grenze). */
  warenNet: number;
  /** davon Betriebskosten (> Grenze). */
  betriebNet: number;
  count: number;
}

/**
 * Lieferanten-Auswertung mit GESAMT-Total über alle Konten und Aufschlüsselung
 * Waren-/Betriebskosten. Sortierung: Gesamt-Total absteigend.
 */
export function aggregateBySupplierKlassen(
  invoices: InvoiceEntry[], grenze: number = DEFAULT_WARENKOSTEN_GRENZE,
): SupplierKlassenRow[] {
  const map = new Map<string, SupplierKlassenRow>();
  for (const e of invoices) {
    const key = (e.supplierName || '—').trim() || '—';
    const row = map.get(key) ?? { supplierName: key, totalNet: 0, warenNet: 0, betriebNet: 0, count: 0 };
    const a = klassenAnteile(e, grenze);
    row.warenNet += a.warenNet;
    row.betriebNet += a.betriebNet;
    row.totalNet += a.warenNet + a.betriebNet;
    row.count += 1;
    map.set(key, row);
  }
  return Array.from(map.values())
    .sort((a, b) => b.totalNet - a.totalNet || a.supplierName.localeCompare(b.supplierName, 'de'));
}

/**
 * Rechnungen auf ihren WARENKOSTEN-Anteil reduziert (amountNet/amountGross
 * anteilig), Einträge ohne Waren-Anteil entfernt. Für bestehende
 * Waren-Aggregationen (Cockpit-Lieferanten-Zeilen, Food/Bev-Quoten), die mit
 * ganzen InvoiceEntry-Listen arbeiten. Split-Listen werden auf die
 * Warenkosten-Zeilen gefiltert, damit kategorieShares konsistent bleibt.
 */
export function nurWarenAnteil(invoices: InvoiceEntry[], grenze: number = DEFAULT_WARENKOSTEN_GRENZE): InvoiceEntry[] {
  const out: InvoiceEntry[] = [];
  for (const e of invoices) {
    if (e.kontoSplits && e.kontoSplits.length > 0) {
      const waren = e.kontoSplits.filter(s => kontoKlasse(s.warenkonto, grenze) === 'warenkosten');
      if (waren.length === 0) continue;
      if (waren.length === e.kontoSplits.length) { out.push(e); continue; }
      out.push({
        ...e,
        kontoSplits: waren,
        amountNet: waren.reduce((s, x) => s + (Number.isFinite(x.amountNet) ? x.amountNet : 0), 0),
        amountGross: waren.reduce((s, x) => s + (Number.isFinite(x.amountGross) ? x.amountGross : 0), 0),
      });
      continue;
    }
    if (kontoKlasse(e.warenkonto, grenze) === 'warenkosten') out.push(e);
  }
  return out;
}
