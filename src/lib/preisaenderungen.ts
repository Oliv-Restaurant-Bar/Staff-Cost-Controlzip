/**
 * Persistente Preisänderungs-Ansicht (Preishistorie) — reine Lade-/Aggregat-Logik
 * ===============================================================================
 * SSOT der ERKENNUNG bleibt `berechnePreisAenderungen` (waren-positionen.ts):
 * jeder Importweg (CSV, Feldschlösschen, Beaulieu-PDF) persistiert seine
 * erkannten Änderungen bereits pro Monat unter `waren_preishinweise_<YYYY-MM>_v1`
 * (Record<invoiceId, PreisAenderung[]>). Diese Datei ERKENNT NICHTS NEU —
 * sie liest ausschliesslich die persistierten Hinweise und reichert sie an:
 *  - Datum + Lieferant aus der zugehörigen Rechnung (supplier_invoices_<monat>)
 *  - Warenkonto/Warengruppe aus den persistierten Positionen (waren_positionen_*)
 *  - kumulierter Mehraufwand = Δ CHF × bezogene Menge IM ZEITRAUM ab der
 *    Änderung: nur Rechnungen mit max(Änderungsdatum, von) ≤ Datum ≤ bis
 *    zählen — die Wochenansicht summiert nie Bezüge ausserhalb der Woche.
 * «Leer statt 0»: fehlt die Mengen-Basis, bleibt der Mehraufwand null (–),
 * nie stilles 0. Mandantentrennung via tenantKey in waren-db-Loadern.
 */

import type { TenantId } from '@/contexts/TenantContext';
import {
  loadPreisHinweise, loadMonthInvoices, loadRechnungsPositionen, type InvoiceEntry,
} from './waren-db';
import { artikelKey, type PreisAenderung, type GespeichertePosition } from './waren-positionen';

export interface PreisAenderungRow extends PreisAenderung {
  /** Datum der Rechnung, die den neuen Preis brachte (YYYY-MM-DD; '' wenn unbekannt). */
  datum: string;
  /** Monat des persistierten Hinweises (YYYY-MM) — Fallback-Zeitanker. */
  monat: string;
  lieferant: string;
  /** Warenkonto der Position (null = Pfand/offen/unbekannt). */
  konto: string | null;
  warengruppe: string;
  /** Bezogene Menge im Zeitraum ab der Änderung (null = keine Positionsdaten). */
  mengeSeit: number | null;
  /** Δ CHF × mengeSeit — was die Änderung real gekostet hat (null = leer). */
  mehraufwand: number | null;
}

/** Lieferant aus dem artikelKey (`<lieferant>|nr:…` / `<lieferant>|name:…`). */
export function lieferantAusKey(key: string): string {
  const i = key.indexOf('|');
  return i > 0 ? key.slice(0, i) : key;
}

interface MonatsDaten {
  monat: string;
  hinweise: Record<string, PreisAenderung[]>;
  invoices: InvoiceEntry[];
  positionen: Record<string, GespeichertePosition[]>;
}

/** Roh-Daten der Monate laden (parallel, tolerant — fehlende Monate = leer). */
async function ladeMonate(tenantId: TenantId, monthKeys: string[]): Promise<MonatsDaten[]> {
  return Promise.all(monthKeys.map(async monat => {
    const [hinweise, invoices, positionen] = await Promise.all([
      loadPreisHinweise(tenantId, monat).catch(() => ({})),
      loadMonthInvoices(tenantId, monat).catch(() => [] as InvoiceEntry[]),
      loadRechnungsPositionen(tenantId, monat).catch(() => ({})),
    ]);
    return { monat, hinweise, invoices, positionen };
  }));
}

/**
 * Alle persistierten Preisänderungen der Monate als angereicherte Zeilen.
 * Mehrfache Änderungen desselben Artikels bleiben getrennte Zeilen —
 * zusammen bilden sie den Preisverlauf (alt→neu-Schritte mit Datum).
 */
export async function ladePreisAenderungen(
  tenantId: TenantId, monthKeys: string[],
  /** Zeitraum-Grenzen (inklusive) für die Mengen-Basis des Mehraufwands. */
  zeitraum?: { von: string; bis: string },
): Promise<PreisAenderungRow[]> {
  const monate = await ladeMonate(tenantId, monthKeys);

  // Rechnungs-Index (id → Entry) über alle Monate.
  const invById = new Map<string, InvoiceEntry>();
  for (const m of monate) for (const inv of m.invoices) invById.set(inv.id, inv);

  // Mengen-Basis: artikelKey → Liste { datum, menge } aus allen Positionen.
  // Lieferant je Position = supplierName der Rechnung (gleiche Quelle wie die
  // Erkennung beim Import, die den Markt→Lieferant bereits aufgelöst hat).
  const mengen = new Map<string, Array<{ datum: string; menge: number }>>();
  for (const m of monate) {
    for (const [invId, posListe] of Object.entries(m.positionen)) {
      const inv = invById.get(invId);
      if (!inv) continue;
      for (const p of posListe) {
        const key = artikelKey(inv.supplierName, p);
        if (!key || !Number.isFinite(p.menge)) continue;
        const list = mengen.get(key) ?? [];
        list.push({ datum: inv.date, menge: p.menge });
        mengen.set(key, list);
      }
    }
  }

  const rows: PreisAenderungRow[] = [];
  for (const m of monate) {
    for (const [invId, aenderungen] of Object.entries(m.hinweise)) {
      if (!Array.isArray(aenderungen)) continue;
      const inv = invById.get(invId);
      const datum = inv?.date ?? '';
      for (const a of aenderungen) {
        if (!a || typeof a !== 'object' || typeof a.key !== 'string') continue;
        // Konto/Warengruppe aus der Position derselben Rechnung (Key-Match).
        let konto: string | null = null;
        let warengruppe = '';
        const posListe = m.positionen[invId];
        if (posListe && inv) {
          const pos = posListe.find(p => artikelKey(inv.supplierName, p) === a.key);
          if (pos) { konto = pos.konto; warengruppe = pos.warengruppe ?? ''; }
        }
        // Menge im Zeitraum ab der Änderung (nur Datensätze mit bekanntem
        // Datum; das Änderungs-Datum selbst zählt mit — die Rechnung mit dem
        // neuen Preis ist bereits zum neuen Preis bezogen). Zeitraum-Grenzen
        // kappen beidseitig (Woche über Monatsgrenze!).
        let mengeSeit: number | null = null;
        const basis = mengen.get(a.key);
        if (basis && datum) {
          const von = zeitraum && zeitraum.von > datum ? zeitraum.von : datum;
          const bis = zeitraum?.bis ?? '9999-12-31';
          const summe = basis.reduce(
            (s, e) => (e.datum >= von && e.datum <= bis ? s + e.menge : s), 0);
          mengeSeit = Math.round(summe * 100) / 100;
        }
        const mehraufwand = mengeSeit !== null && mengeSeit > 0
          ? Math.round(a.diffAbs * mengeSeit * 100) / 100
          : null;
        rows.push({
          ...a,
          datum, monat: m.monat,
          lieferant: inv?.supplierName ?? lieferantAusKey(a.key),
          konto, warengruppe, mengeSeit, mehraufwand,
        });
      }
    }
  }
  return rows;
}

export type PreisRichtung = 'alle' | 'erhoehung' | 'senkung';

export interface PreisFilter {
  /** Zeitraum-Grenzen (YYYY-MM-DD, inklusive). */
  von: string;
  bis: string;
  lieferant: string;      // '' = alle
  warengruppe: string;    // '' = alle
  nurStark: boolean;      // true = nur |Δ%| ≥ Schwelle (Default ±10%)
  richtung: PreisRichtung;
}

/** Zeitanker einer Zeile: Rechnungsdatum, sonst Monats-Fallback (Monatsmitte-neutral: 01/31). */
function imZeitraum(r: PreisAenderungRow, von: string, bis: string): boolean {
  if (r.datum) return r.datum >= von && r.datum <= bis;
  return `${r.monat}-31` >= von && `${r.monat}-01` <= bis;
}

/** Filter + Standard-Sortierung: grösste Erhöhung (Δ%) zuerst, Senkungen zuletzt. */
export function filtereUndSortiere(
  rows: PreisAenderungRow[], f: PreisFilter,
): PreisAenderungRow[] {
  const norm = (s: string) => s.trim().toLowerCase();
  return rows
    .filter(r => imZeitraum(r, f.von, f.bis))
    .filter(r => !f.lieferant || norm(r.lieferant) === norm(f.lieferant))
    .filter(r => !f.warengruppe || norm(r.warengruppe) === norm(f.warengruppe))
    .filter(r => !f.nurStark || r.stark)
    .filter(r => f.richtung === 'alle'
      || (f.richtung === 'erhoehung' ? r.erhoehung : !r.erhoehung))
    .sort((a, b) =>
      Number(b.erhoehung) - Number(a.erhoehung)
      || (b.erhoehung
        ? (b.diffPct ?? -Infinity) - (a.diffPct ?? -Infinity)
        : (a.diffPct ?? Infinity) - (b.diffPct ?? Infinity))
      || Math.abs(b.diffAbs) - Math.abs(a.diffAbs));
}
