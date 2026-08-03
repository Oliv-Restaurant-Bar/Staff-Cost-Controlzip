/**
 * waren-klassen.ts — Kontoklassen für Warenrechnungen (pure, IO-frei)
 * ====================================================================
 * Klassifikation NACH KONTONUMMER:
 *   - Konten 4000 … Grenze (Standard 4090)  → WARENKOSTEN  (zählen in WKQ)
 *   - Konten > Grenze (z.B. 4701, 6040)     → BETRIEBSKOSTEN (NICHT in WKQ)
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
import { normalizeWarenKonto } from './warenaufwand-gruppierung';

/**
 * Standard-Obergrenze der Warenkosten-Konten (4000–4090): alle
 * «…Warenaufwand»-Konten inkl. 4070 Kaffee/Tee und 4090 Übriger Handelswaren.
 * 4701 Betriebsmaterial und übrige 47xx/48xx = Betriebskosten (NICHT in der WKQ).
 * Identisch für Oliv und Beaulieu; je Mandant in den Stammdaten anpassbar.
 */
export const DEFAULT_WARENKOSTEN_GRENZE = 4090;

export type KontoKlasse = 'warenkosten' | 'betriebskosten' | 'neutral';

/**
 * Pseudo-Konto «Depot» (Pfand/Gebinde aus dem CSV-Positionsimport, MwSt-Code 0):
 * NEUTRAL — zählt weder zu Warenkosten noch Betriebskosten (Depot gleicht sich
 * über Rückgaben aus). Muss mit KONTO_LABEL_PFAND in waren-positionen.ts
 * übereinstimmen (hier dupliziert, um Import-Zyklen zu vermeiden).
 */
export const PSEUDO_KONTO_PFAND = 'Depot';
/**
 * Pseudo-Konto «offen» (unbekannte Warengruppe, noch nicht zugeordnet):
 * BEWUSSTE Policy — zählt bis zur Zuordnung als Warenkosten (wie die
 * Legacy-Regel für kontolose Einträge), damit Totale/WKQ nicht absacken,
 * nur weil eine Zuordnung noch fehlt. Muss KONTO_LABEL_OFFEN entsprechen.
 */
export const PSEUDO_KONTO_OFFEN = 'offen';

/**
 * Klasse eines Kontos aus der Nummer. Kein/kein-numerisches Konto → warenkosten
 * (Legacy-Regel, siehe Kopfkommentar). Ausnahme: Pseudo-Konto «Depot» → neutral.
 */
export function kontoKlasse(konto: string | undefined, grenze: number = DEFAULT_WARENKOSTEN_GRENZE): KontoKlasse {
  if (konto === PSEUDO_KONTO_PFAND) return 'neutral';
  if (!konto) return 'warenkosten';
  const n = parseInt(konto, 10);
  if (!Number.isFinite(n)) return 'warenkosten'; // inkl. «offen» — bewusste Policy, s.o.
  return n >= 4000 && n <= grenze ? 'warenkosten' : 'betriebskosten';
}

export function kontoKlasseLabel(k: KontoKlasse): string {
  return k === 'warenkosten' ? 'Warenkosten' : k === 'neutral' ? 'Neutral (Depot)' : 'Betriebskosten';
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
      const kl = kontoKlasse(s.warenkonto, grenze);
      if (kl === 'warenkosten') r.warenNet += net;
      else if (kl === 'betriebskosten') r.betriebNet += net;
      // 'neutral' (Depot/Pfand): weder Waren- noch Betriebskosten.
    }
    return r;
  }
  const net = Number.isFinite(e.amountNet) ? e.amountNet : 0;
  const kl = kontoKlasse(e.warenkonto, grenze);
  if (kl === 'warenkosten') r.warenNet = net;
  else if (kl === 'betriebskosten') r.betriebNet = net;
  return r;
}

/**
 * STRIKTE Prüfung fürs Lieferanten-Journal: nur numerische Konten 4000–Grenze.
 * Anders als `kontoKlasse` gibt es hier KEINE Legacy-Regel — Buchungen ohne
 * bzw. mit nicht-numerischem Konto gehören NICHT ins Lieferanten-Journal
 * (5-stellige Konten werden auf die ersten 4 Stellen normalisiert).
 */
export function istWarenJournalKonto(
  accountNumber: string | undefined,
  grenze: number = DEFAULT_WARENKOSTEN_GRENZE,
): boolean {
  const n = normalizeWarenKonto(accountNumber);
  return n !== null && n >= 4000 && n <= grenze;
}

/**
 * Filtert Buchungszeilen fürs LIEFERANTEN-Journal (FIBU-Abgleich mit den
 * Warenrechnungen): nur Warenaufwand-Konten 4000–Grenze. Löhne (5xxx),
 * Betriebskosten (6xxx), 4701 Betriebsmaterial, 4800 Gebinde-Verrechnung und
 * 4900 Warenvorrat fliessen NICHT ins Journal. Die Erfolgsrechnung/Konto-
 * beträge bleiben davon unberührt (dort werden ALLE Konten gespeichert).
 */
export function splitWarenJournal<T extends { accountNumber?: string }>(
  entries: T[],
  grenze: number = DEFAULT_WARENKOSTEN_GRENZE,
): { waren: T[]; nichtWaren: T[] } {
  const waren: T[] = [];
  const nichtWaren: T[] = [];
  for (const e of entries) {
    (istWarenJournalKonto(e.accountNumber, grenze) ? waren : nichtWaren).push(e);
  }
  return { waren, nichtWaren };
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
